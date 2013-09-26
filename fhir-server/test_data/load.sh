#!/bin/bash
which node
echo -n "loading observations...."
out=`node load list observation`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading patients...."
out=`node load patient patient`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading practitioners...."
out=`node load practitioner practitioner`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading medications...."
out=`node load medication medication`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading substances...."
out=`node load substance substance`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo -n "loading organizations...."
out=`node load organization organization`
if [ $? -ne 0 ] ; then
    echo "failed."
    exit 127
else
    echo "ok."
fi

echo "done.
"
